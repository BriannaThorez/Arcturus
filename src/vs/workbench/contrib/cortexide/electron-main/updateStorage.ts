/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { promises as fsPromises } from 'fs';
import { IEnvironmentMainService } from '../../../../platform/environment/electron-main/environmentMainService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Promises } from '../../../../base/node/pfs.js';

interface UpdateStorageData {
	// Version that was last notified to the user
	lastNotifiedVersion: string | null;
	// Timestamp when user clicked "Remind me later"
	remindLaterTimestamp: number | null;
	// Versions that have been dismissed (user doesn't want to see them)
	dismissedVersions: string[];
}

const STORAGE_FILE_NAME = 'update-storage.json';
const REMIND_LATER_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Manages persistent storage for update preferences
 */
export class UpdateStorage {
	private storagePath: string;
	private data: UpdateStorageData | null = null;

	constructor(
		private readonly environmentService: IEnvironmentMainService,
		private readonly logService: ILogService
	) {
		// Use user data directory for storage
		const userDataPath = this.environmentService.userDataPath;
		this.storagePath = path.join(userDataPath, STORAGE_FILE_NAME);
	}

	/**
	 * Load storage data from disk
	 */
	async load(): Promise<UpdateStorageData> {
		if (this.data !== null) {
			return this.data;
		}

		try {
			if (await Promises.exists(this.storagePath)) {
				const content = await fsPromises.readFile(this.storagePath, 'utf8');
				this.data = JSON.parse(content) as UpdateStorageData;
				// Validate and normalize data
				this.data = {
					lastNotifiedVersion: this.data.lastNotifiedVersion || null,
					remindLaterTimestamp: this.data.remindLaterTimestamp || null,
					dismissedVersions: Array.isArray(this.data.dismissedVersions) ? this.data.dismissedVersions : [],
				};
			} else {
				this.data = {
					lastNotifiedVersion: null,
					remindLaterTimestamp: null,
					dismissedVersions: [],
				};
			}
		} catch (error) {
			this.logService.warn('[UpdateStorage] Failed to load storage, using defaults:', error);
			this.data = {
				lastNotifiedVersion: null,
				remindLaterTimestamp: null,
				dismissedVersions: [],
			};
		}

		return this.data;
	}

	/**
	 * Save storage data to disk
	 */
	async save(): Promise<void> {
		if (this.data === null) {
			await this.load();
		}

		try {
			// Ensure directory exists
			await fsPromises.mkdir(path.dirname(this.storagePath), { recursive: true });
			await Promises.writeFile(this.storagePath, JSON.stringify(this.data, null, 2));
		} catch (error) {
			this.logService.error('[UpdateStorage] Failed to save storage:', error);
		}
	}

	/**
	 * Check if we should notify about this version
	 */
	async shouldNotify(version: string): Promise<boolean> {
		const data = await this.load();

		// Don't notify if version is dismissed
		if (data.dismissedVersions.includes(version)) {
			return false;
		}

		// Don't notify if we already notified about this version
		if (data.lastNotifiedVersion === version) {
			return false;
		}

		// Check if "remind later" is still active
		if (data.remindLaterTimestamp !== null) {
			const now = Date.now();
			const timeSinceRemind = now - data.remindLaterTimestamp;
			if (timeSinceRemind < REMIND_LATER_DURATION_MS) {
				// Still within remind later period
				return false;
			} else {
				// Remind later period expired, clear it
				data.remindLaterTimestamp = null;
				await this.save();
			}
		}

		return true;
	}

	/**
	 * Mark version as notified
	 */
	async markNotified(version: string): Promise<void> {
		const data = await this.load();
		data.lastNotifiedVersion = version;
		// Clear remind later when user sees a new version
		data.remindLaterTimestamp = null;
		await this.save();
	}

	/**
	 * Set remind later timestamp
	 */
	async setRemindLater(): Promise<void> {
		const data = await this.load();
		data.remindLaterTimestamp = Date.now();
		await this.save();
	}

	/**
	 * Dismiss a version (user doesn't want to see it)
	 */
	async dismissVersion(version: string): Promise<void> {
		const data = await this.load();
		if (!data.dismissedVersions.includes(version)) {
			data.dismissedVersions.push(version);
			// Keep only last 10 dismissed versions
			if (data.dismissedVersions.length > 10) {
				data.dismissedVersions = data.dismissedVersions.slice(-10);
			}
			await this.save();
		}
	}

	/**
	 * Clear all storage
	 */
	async clear(): Promise<void> {
		this.data = {
			lastNotifiedVersion: null,
			remindLaterTimestamp: null,
			dismissedVersions: [],
		};
		await this.save();
	}
}

