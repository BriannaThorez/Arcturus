/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';

export interface InstallOptions { method: 'auto' | 'brew' | 'curl' | 'winget' | 'choco'; modelTag?: string }

export interface IOllamaInstallerService {
	readonly _serviceBrand: undefined;
	onLog: Event<string>;
	onDone: Event<boolean>;
	install(options: InstallOptions): void;
}

export const IOllamaInstallerService = createDecorator<IOllamaInstallerService>('OllamaInstallerService');

export class OllamaInstallerService extends Disposable implements IOllamaInstallerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onLog = this._register(new Emitter<string>());
	readonly onLog = this._onLog.event;

	private readonly _onDone = this._register(new Emitter<boolean>());
	readonly onDone = this._onDone.event;

	constructor(
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		const channel = this.mainProcessService.getChannel('void-channel-ollamaInstaller');
		this._register((channel.listen('onLog') satisfies Event<{ text: string }>)((e) => {
			this._onLog.fire(e.text);
		}));
		this._register((channel.listen('onDone') satisfies Event<{ ok: boolean }>)((e) => {
			this._onDone.fire(e.ok);
		}));
	}

	install(options: InstallOptions) {
		const channel = this.mainProcessService.getChannel('void-channel-ollamaInstaller');
		channel.call('install', options);
	}
}

registerSingleton(IOllamaInstallerService, OllamaInstallerService, InstantiationType.Delayed);

