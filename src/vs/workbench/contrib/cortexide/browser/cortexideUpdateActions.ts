/*---------------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { INotificationActions, INotificationHandle, INotificationService } from '../../../../platform/notification/common/notification.js';
import { IMetricsService } from '../common/metricsService.js';
import { ICortexideUpdateService } from '../common/cortexideUpdateService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import * as dom from '../../../../base/browser/dom.js';
import { IUpdateService } from '../../../../platform/update/common/update.js';
import { CortexideCheckUpdateResponse } from '../common/cortexideUpdateServiceTypes.js';
import { IAction } from '../../../../base/common/actions.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';




const notifyUpdate = (
	res: CortexideCheckUpdateResponse & { message: string },
	notifService: INotificationService,
	updateService: IUpdateService,
	cortexideUpdateService: ICortexideUpdateService,
	nativeHostService: INativeHostService
): INotificationHandle => {
	const message = res?.message || 'This is a very old version. Please download the latest CortexIDE!'

	// Format message with version if available
	let displayMessage = message;
	if (res.version) {
		displayMessage = `Update available: ${res.version}\n${message}`;
	}

	// Extract release notes snippet (first 200 chars)
	let releaseNotesSnippet: string | undefined;
	if (res.releaseNotes) {
		const cleanNotes = res.releaseNotes.replace(/[#*`]/g, '').trim();
		releaseNotesSnippet = cleanNotes.length > 200
			? cleanNotes.substring(0, 200) + '...'
			: cleanNotes;
	}

	let actions: INotificationActions | undefined

	if (res?.action) {
		const primary: IAction[] = []

		if (res.action === 'reinstall' || res.action === 'download') {
			primary.push({
				label: `Download & Install`,
				id: 'void.updater.download',
				enabled: true,
				tooltip: 'Download the latest version from GitHub Releases',
				class: undefined,
				run: async () => {
					// Open GitHub Releases page
					const { window } = dom.getActiveWindow()
					window.open('https://github.com/OpenCortexIDE/cortexide/releases/latest')

					// Also try to trigger built-in download if available
					try {
						if (updateService.state.type === 'available for download') {
							await updateService.downloadUpdate()
						}
					} catch (error) {
						// Ignore errors, user can download manually
					}
				}
			})
		}

		if (res.action === 'apply') {
			primary.push({
				label: `Apply Update`,
				id: 'void.updater.apply',
				enabled: true,
				tooltip: 'Apply the downloaded update',
				class: undefined,
				run: async () => {
					await updateService.applyUpdate()
				}
			})
		}

		if (res.action === 'restart') {
			primary.push({
				label: `Restart to Update`,
				id: 'void.updater.restart',
				enabled: true,
				tooltip: 'Restart CortexIDE to apply the update',
				class: undefined,
				run: () => {
					updateService.quitAndInstall()
				}
			})
		}

		// View release notes action
		if (res.releaseNotes) {
			primary.push({
				id: 'void.updater.releasenotes',
				enabled: true,
				label: `View Release Notes`,
				tooltip: 'View full release notes on GitHub',
				class: undefined,
				run: () => {
					const { window } = dom.getActiveWindow()
					const version = res.version || 'latest'
					window.open(`https://github.com/OpenCortexIDE/cortexide/releases/tag/${version}`)
				}
			})
		}

		const secondary: IAction[] = [
			{
				id: 'void.updater.remindlater',
				enabled: true,
				label: `Remind me later`,
				tooltip: 'Remind me about this update in 24 hours',
				class: undefined,
				run: async () => {
					await cortexideUpdateService.setRemindLater()
					notifController.close()
				}
			},
			{
				id: 'void.updater.close',
				enabled: true,
				label: `Dismiss`,
				tooltip: 'Dismiss this update notification',
				class: undefined,
				run: async () => {
					if (res.version) {
						await cortexideUpdateService.dismissVersion(res.version)
					}
					notifController.close()
				}
			}
		]

		actions = {
			primary: primary,
			secondary: secondary,
		}
	}
	else {
		actions = undefined
	}

	// Build full message with release notes snippet
	let fullMessage = displayMessage;
	if (releaseNotesSnippet) {
		fullMessage += `\n\n${releaseNotesSnippet}`;
	}

	const notifController = notifService.notify({
		severity: Severity.Info,
		message: fullMessage,
		sticky: true,
		progress: actions ? { worked: 0, total: 100 } : undefined,
		actions: actions,
	})

	return notifController
}
const notifyErrChecking = (notifService: INotificationService): INotificationHandle => {
	const message = `There was an error checking for updates. If this persists, please reinstall CortexIDE.`
	const notifController = notifService.notify({
		severity: Severity.Info,
		message: message,
		sticky: true,
	})
	return notifController
}


const performVoidCheck = async (
	explicit: boolean,
	notifService: INotificationService,
	cortexideUpdateService: ICortexideUpdateService,
	metricsService: IMetricsService,
	updateService: IUpdateService,
	nativeHostService: INativeHostService,
): Promise<INotificationHandle | null> => {

	const metricsTag = explicit ? 'Manual' : 'Auto'

	metricsService.capture(`CortexIDE Update ${metricsTag}: Checking...`, {})
	const res = await cortexideUpdateService.check(explicit)
	if (!res) {
		const notifController = notifyErrChecking(notifService);
		metricsService.capture(`CortexIDE Update ${metricsTag}: Error`, { res })
		return notifController
	}
	else {
		if (res.message) {
			const notifController = notifyUpdate(res, notifService, updateService, cortexideUpdateService, nativeHostService)
			metricsService.capture(`CortexIDE Update ${metricsTag}: Yes`, { res })
			return notifController
		}
		else {
			metricsService.capture(`CortexIDE Update ${metricsTag}: No`, { res })
			return null
		}
	}
}


// Action
let lastNotifController: INotificationHandle | null = null


registerAction2(class extends Action2 {
	constructor() {
		super({
			f1: true,
			id: 'void.voidCheckUpdate',
			title: localize2('voidCheckUpdate', 'CortexIDE: Check for Updates'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const cortexideUpdateService = accessor.get(ICortexideUpdateService)
		const notifService = accessor.get(INotificationService)
		const metricsService = accessor.get(IMetricsService)
		const updateService = accessor.get(IUpdateService)
		const nativeHostService = accessor.get(INativeHostService)

		const currNotifController = lastNotifController

		const newController = await performVoidCheck(true, notifService, cortexideUpdateService, metricsService, updateService, nativeHostService)

		if (newController) {
			currNotifController?.close()
			lastNotifController = newController
		}
	}
})

// on mount
class VoidUpdateWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.void.voidUpdate'
	constructor(
		@ICortexideUpdateService cortexideUpdateService: ICortexideUpdateService,
		@IMetricsService metricsService: IMetricsService,
		@INotificationService notifService: INotificationService,
		@IUpdateService updateService: IUpdateService,
		@INativeHostService nativeHostService: INativeHostService,
	) {
		super()

		const autoCheck = () => {
			performVoidCheck(false, notifService, cortexideUpdateService, metricsService, updateService, nativeHostService)
		}

		// check once 5 seconds after mount
		// check every 3 hours
		const { window } = dom.getActiveWindow()

		const initId = window.setTimeout(() => autoCheck(), 5 * 1000)
		this._register({ dispose: () => window.clearTimeout(initId) })


		const intervalId = window.setInterval(() => autoCheck(), 3 * 60 * 60 * 1000) // every 3 hrs
		this._register({ dispose: () => window.clearInterval(intervalId) })

	}
}
registerWorkbenchContribution2(VoidUpdateWorkbenchContribution.ID, VoidUpdateWorkbenchContribution, WorkbenchPhase.BlockRestore);
