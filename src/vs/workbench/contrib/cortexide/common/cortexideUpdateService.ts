/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { CortexideCheckUpdateResponse } from './cortexideUpdateServiceTypes.js';



export interface ICortexideUpdateService {
	readonly _serviceBrand: undefined;
	check: (explicit: boolean) => Promise<CortexideCheckUpdateResponse>;
	setRemindLater: () => Promise<void>;
	dismissVersion: (version: string) => Promise<void>;
}


export const ICortexideUpdateService = createDecorator<ICortexideUpdateService>('CortexideUpdateService');


// implemented by calling channel
export class CortexideUpdateService implements ICortexideUpdateService {

	readonly _serviceBrand: undefined;
	private readonly cortexideUpdateService: ICortexideUpdateService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService, // (only usable on client side)
	) {
		// creates an IPC proxy to use metricsMainService.ts
		this.cortexideUpdateService = ProxyChannel.toService<ICortexideUpdateService>(mainProcessService.getChannel('cortexide-channel-update'));
	}


	// anything transmitted over a channel must be async even if it looks like it doesn't have to be
	check: ICortexideUpdateService['check'] = async (explicit) => {
		const res = await this.cortexideUpdateService.check(explicit)
		return res
	}

	setRemindLater: ICortexideUpdateService['setRemindLater'] = async () => {
		await this.cortexideUpdateService.setRemindLater()
	}

	dismissVersion: ICortexideUpdateService['dismissVersion'] = async (version) => {
		await this.cortexideUpdateService.dismissVersion(version)
	}
}

registerSingleton(ICortexideUpdateService, CortexideUpdateService, InstantiationType.Eager);


