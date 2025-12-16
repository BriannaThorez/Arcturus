/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IUpdate } from '../../../../platform/update/common/update.js';

export interface GitHubRelease {
	tag_name: string;
	name: string;
	body: string;
	published_at: string;
	prerelease: boolean;
	assets: Array<{
		name: string;
		browser_download_url: string;
		size: number;
		content_type: string;
	}>;
}

export interface GitHubReleasesUpdateInfo {
	version: string;
	productVersion: string;
	url: string;
	sha256hash?: string;
	releaseNotes?: string;
	timestamp?: number;
}

/**
 * Service to fetch update information from GitHub Releases
 */
export class GitHubReleasesUpdateService {
	private readonly repoOwner: string;
	private readonly repoName: string;
	private readonly updateChannel: 'stable' | 'insiders';

	constructor(
		private readonly requestService: IRequestService,
		private readonly logService: ILogService,
		_productService: IProductService,
		updateChannel: 'stable' | 'insiders' = 'stable',
		repoOwner?: string,
		repoName?: string
	) {
		// Extract repo info from product service or use defaults
		// Support for cortexide-versions repo if needed, otherwise use main repo
		this.repoOwner = repoOwner || 'OpenCortexIDE';
		this.repoName = repoName || 'cortexide';
		this.updateChannel = updateChannel;
	}

	/**
	 * Compare two semantic versions
	 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
	 */
	private compareVersions(v1: string, v2: string): number {
		// Remove 'v' prefix if present
		const normalize = (v: string) => v.replace(/^v/i, '').trim();
		const v1Norm = normalize(v1);
		const v2Norm = normalize(v2);

		const parts1 = v1Norm.split('.').map(Number);
		const parts2 = v2Norm.split('.').map(Number);

		const maxLength = Math.max(parts1.length, parts2.length);
		for (let i = 0; i < maxLength; i++) {
			const part1 = parts1[i] || 0;
			const part2 = parts2[i] || 0;
			if (part1 > part2) {
				return 1;
			}
			if (part1 < part2) {
				return -1;
			}
		}
		return 0;
	}

	/**
	 * Check if version1 is newer than version2
	 */
	isNewerVersion(version1: string, version2: string): boolean {
		return this.compareVersions(version1, version2) > 0;
	}

	/**
	 * Get the latest release from GitHub
	 */
	async getLatestRelease(): Promise<GitHubRelease | null> {
		try {
			const url = this.updateChannel === 'insiders'
				? `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases`
				: `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`;

			this.logService.trace(`[GitHubReleasesUpdateService] Fetching ${this.updateChannel} releases from: ${url}`);

			const context = await this.requestService.request(
				{ url },
				CancellationToken.None
			);

			if (context.res.statusCode !== 200) {
				this.logService.warn(`[GitHubReleasesUpdateService] Failed to fetch releases: ${context.res.statusCode}`);
				return null;
			}

			if (this.updateChannel === 'insiders') {
				// For insiders, get the latest prerelease
				const releases = await asJson<GitHubRelease[]>(context);
				const prerelease = releases?.find(r => r.prerelease) || releases?.[0];
				return prerelease || null;
			} else {
				// For stable, get the latest non-prerelease
				const release = await asJson<GitHubRelease>(context);
				return release || null;
			}
		} catch (error) {
			this.logService.error('[GitHubReleasesUpdateService] Error fetching latest release:', error);
			return null;
		}
	}

	/**
	 * Get update information for the current platform
	 */
	async getUpdateInfo(currentVersion: string): Promise<GitHubReleasesUpdateInfo | null> {
		const release = await this.getLatestRelease();
		if (!release) {
			return null;
		}

		// Normalize versions for comparison
		const latestVersion = release.tag_name.replace(/^v/i, '');
		const currentVersionNorm = currentVersion.replace(/^v/i, '');

		// Check if update is available
		if (!this.isNewerVersion(latestVersion, currentVersionNorm)) {
			this.logService.trace(`[GitHubReleasesUpdateService] Already up to date. Current: ${currentVersionNorm}, Latest: ${latestVersion}`);
			return null;
		}

		// Find the appropriate asset for the current platform
		const platform = process.platform;
		const arch = process.arch;
		const asset = this.findAssetForPlatform(release.assets, platform, arch);

		if (!asset) {
			this.logService.warn(`[GitHubReleasesUpdateService] No suitable asset found for platform ${platform}-${arch}`);
			return null;
		}

		// Extract SHA256 hash from release notes or assets if available
		const sha256hash = this.extractSha256Hash(release.body, asset.name);

		return {
			version: release.tag_name,
			productVersion: latestVersion,
			url: asset.browser_download_url,
			sha256hash,
			releaseNotes: release.body,
			timestamp: new Date(release.published_at).getTime(),
		};
	}

	/**
	 * Find the appropriate asset for the current platform
	 */
	private findAssetForPlatform(
		assets: GitHubRelease['assets'],
		platform: string,
		arch: string
	): GitHubRelease['assets'][0] | null {
		// Platform-specific asset name patterns
		const patterns: Array<{ pattern: RegExp; priority: number }> = [];

		if (platform === 'win32') {
			if (arch === 'x64') {
				patterns.push({ pattern: /\.exe$/i, priority: 1 });
				patterns.push({ pattern: /win32.*x64.*\.exe$/i, priority: 2 });
				patterns.push({ pattern: /windows.*x64.*\.exe$/i, priority: 2 });
			} else if (arch === 'arm64') {
				patterns.push({ pattern: /win32.*arm64.*\.exe$/i, priority: 1 });
				patterns.push({ pattern: /windows.*arm64.*\.exe$/i, priority: 1 });
			}
		} else if (platform === 'darwin') {
			if (arch === 'x64') {
				patterns.push({ pattern: /\.dmg$/i, priority: 1 });
				patterns.push({ pattern: /darwin.*x64.*\.dmg$/i, priority: 2 });
				patterns.push({ pattern: /macos.*x64.*\.dmg$/i, priority: 2 });
			} else if (arch === 'arm64') {
				patterns.push({ pattern: /darwin.*arm64.*\.dmg$/i, priority: 1 });
				patterns.push({ pattern: /macos.*arm64.*\.dmg$/i, priority: 1 });
				patterns.push({ pattern: /universal.*\.dmg$/i, priority: 2 });
			}
		} else if (platform === 'linux') {
			if (arch === 'x64') {
				patterns.push({ pattern: /\.AppImage$/i, priority: 1 });
				patterns.push({ pattern: /linux.*x64.*\.AppImage$/i, priority: 2 });
				patterns.push({ pattern: /\.deb$/i, priority: 3 });
				patterns.push({ pattern: /\.rpm$/i, priority: 4 });
			} else if (arch === 'arm64') {
				patterns.push({ pattern: /linux.*arm64.*\.AppImage$/i, priority: 1 });
				patterns.push({ pattern: /\.AppImage$/i, priority: 2 });
			}
		}

		// Sort assets by pattern match priority
		for (const { pattern } of patterns.sort((a, b) => a.priority - b.priority)) {
			const asset = assets.find(a => pattern.test(a.name));
			if (asset) {
				return asset;
			}
		}

		// Fallback: return first asset if no pattern matches
		return assets[0] || null;
	}

	/**
	 * Extract SHA256 hash from release notes or asset name
	 * Looks for patterns like "SHA256: abc123..." or "sha256sum: abc123..."
	 */
	private extractSha256Hash(releaseNotes: string, assetName: string): string | undefined {
		// Try to find hash in release notes
		const hashPatterns = [
			/SHA256[:\s]+([a-fA-F0-9]{64})/i,
			/sha256sum[:\s]+([a-fA-F0-9]{64})/i,
			/checksum[:\s]+([a-fA-F0-9]{64})/i,
		];

		for (const pattern of hashPatterns) {
			const match = releaseNotes.match(pattern);
			if (match && match[1]) {
				return match[1].toLowerCase();
			}
		}

		// Try to find hash file in assets (e.g., asset.sha256)
		// This would require another API call, so we'll skip for now
		return undefined;
	}

	/**
	 * Convert GitHub release to VS Code update format
	 */
	toUpdateFormat(release: GitHubRelease, updateInfo: GitHubReleasesUpdateInfo): IUpdate {
		return {
			version: updateInfo.version,
			productVersion: updateInfo.productVersion,
			url: updateInfo.url,
			sha256hash: updateInfo.sha256hash,
			timestamp: updateInfo.timestamp,
		};
	}
}

