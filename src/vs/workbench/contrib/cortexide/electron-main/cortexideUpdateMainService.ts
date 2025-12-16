/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IUpdateService, StateType } from '../../../../platform/update/common/update.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICortexideUpdateService } from '../common/cortexideUpdateService.js';
import { CortexideCheckUpdateResponse } from '../common/cortexideUpdateServiceTypes.js';
import { GitHubReleasesUpdateService } from './githubReleasesUpdateService.js';
import { UpdateStorage } from './updateStorage.js';



export class CortexideMainUpdateService extends Disposable implements ICortexideUpdateService {
	readonly _serviceBrand: undefined;

	private readonly githubUpdateService: GitHubReleasesUpdateService;
	private readonly updateStorage: UpdateStorage;
	private currentUpdateInfo: { version: string; releaseNotes?: string } | null = null;

	constructor(
		@IProductService private readonly _productService: IProductService,
		@IEnvironmentMainService private readonly _envMainService: IEnvironmentMainService,
		@IUpdateService private readonly _updateService: IUpdateService,
		@IRequestService private readonly _requestService: IRequestService,
		@ILogService private readonly _logService: ILogService,
	) {
		super()

		// Determine update channel (default to stable, can be configured)
		const updateChannel = this._productService.quality === 'insider' ? 'insiders' : 'stable';

		this.githubUpdateService = new GitHubReleasesUpdateService(
			this._requestService,
			this._logService,
			this._productService,
			updateChannel
		);

		this.updateStorage = new UpdateStorage(this._envMainService, this._logService);
	}


	async check(explicit: boolean): Promise<CortexideCheckUpdateResponse> {

		const isDevMode = !this._envMainService.isBuilt // found in abstractUpdateService.ts

		if (isDevMode) {
			return { message: null } as const
		}

		// First, try to use the built-in update service if available
		if (this._updateService.state.type !== StateType.Disabled) {
			this._updateService.checkForUpdates(false) // implicit check, then handle result ourselves

			if (this._updateService.state.type === StateType.Uninitialized) {
				// The update service hasn't been initialized yet
				return { message: explicit ? 'Checking for updates soon...' : null, action: explicit ? 'reinstall' : undefined } as const
			}

			if (this._updateService.state.type === StateType.Idle) {
				// No updates currently available from built-in service
				// Fall through to GitHub Releases check
			} else if (this._updateService.state.type === StateType.CheckingForUpdates) {
				// Currently checking for updates
				return { message: explicit ? 'Checking for updates...' : null } as const
			} else if (this._updateService.state.type === StateType.AvailableForDownload) {
				// Update available but requires manual download (mainly for Linux)
				return { message: 'A new update is available!', action: 'download', } as const
			} else if (this._updateService.state.type === StateType.Downloading) {
				// Update is currently being downloaded
				return { message: explicit ? 'Currently downloading update...' : null } as const
			} else if (this._updateService.state.type === StateType.Downloaded) {
				// Update has been downloaded but not yet ready
				return { message: explicit ? 'An update is ready to be applied!' : null, action: 'apply' } as const
			} else if (this._updateService.state.type === StateType.Updating) {
				// Update is being applied
				return { message: explicit ? 'Applying update...' : null } as const
			} else if (this._updateService.state.type === StateType.Ready) {
				// Update is ready
				return { message: 'Restart CortexIDE to update!', action: 'restart' } as const
			}
		}

		// Fallback to GitHub Releases check
		return await this._checkGitHubReleases(explicit)
	}




	/**
	 * Check for updates using GitHub Releases
	 */
	private async _checkGitHubReleases(explicit: boolean): Promise<CortexideCheckUpdateResponse> {
		try {
			const currentVersion = this._productService.version;
			const updateInfo = await this.githubUpdateService.getUpdateInfo(currentVersion);

			if (!updateInfo) {
				// No update available
				if (explicit) {
					return { message: 'CortexIDE is up-to-date!', action: undefined } as const;
				}
				return { message: null } as const;
			}

			// Check if we should notify about this version
			const shouldNotify = await this.updateStorage.shouldNotify(updateInfo.version);

			if (!explicit && !shouldNotify) {
				// Don't show notification if user dismissed or asked to remind later
				return { message: null } as const;
			}

			// Store update info for later use
			this.currentUpdateInfo = {
				version: updateInfo.version,
				releaseNotes: updateInfo.releaseNotes,
			};

			// Mark as notified
			await this.updateStorage.markNotified(updateInfo.version);

			// Determine action based on platform
			const platform = process.platform;
			let action: 'download' | 'restart' | 'reinstall' | undefined;
			let message: string;

			if (platform === 'linux') {
				// Linux: typically requires manual download
				action = 'download';
				message = `Update available: ${updateInfo.productVersion}`;
			} else {
				// Windows/macOS: can use built-in update mechanism
				// Try to trigger the built-in update service
				try {
					// Convert GitHub release to VS Code update format and trigger update
					const release = await this.githubUpdateService.getLatestRelease();
					if (release) {
						// Note: We can't directly inject this into the update service,
						// but we can provide download URL
						action = 'download';
						message = `Update available: ${updateInfo.productVersion}. Click to download and install.`;
					} else {
						action = 'reinstall';
						message = `Update available: ${updateInfo.productVersion}. Please download from GitHub Releases.`;
					}
				} catch (error) {
					this._logService.warn('[CortexideUpdateService] Failed to trigger built-in update:', error);
					action = 'reinstall';
					message = `Update available: ${updateInfo.productVersion}. Please download from GitHub Releases.`;
				}
			}

			return {
				message,
				action,
				version: updateInfo.version,
				releaseNotes: updateInfo.releaseNotes,
			} as CortexideCheckUpdateResponse;
		} catch (error) {
			this._logService.error('[CortexideUpdateService] Error checking GitHub Releases:', error);

			if (explicit) {
				return {
					message: `An error occurred when checking for updates: ${error}. Please try again later.`,
					action: 'reinstall',
				} as const;
			}

			return { message: null } as const;
		}
	}

	/**
	 * Set remind later for current update
	 */
	async setRemindLater(): Promise<void> {
		await this.updateStorage.setRemindLater();
	}

	/**
	 * Dismiss current update version
	 */
	async dismissVersion(version: string): Promise<void> {
		await this.updateStorage.dismissVersion(version);
	}

	/**
	 * Get current update info (for UI display)
	 */
	getCurrentUpdateInfo(): { version: string; releaseNotes?: string } | null {
		return this.currentUpdateInfo;
	}
}
