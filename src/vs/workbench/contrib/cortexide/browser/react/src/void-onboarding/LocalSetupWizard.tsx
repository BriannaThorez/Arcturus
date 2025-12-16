/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { Check, X, Loader2, AlertCircle, ChevronRight } from 'lucide-react';
import { ModelPackType, LocalSetupState } from '../../../../common/localSetupServiceTypes.js';
import { getAllModelPacks } from '../../../../common/modelPacks.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';

interface LocalSetupWizardProps {
	onComplete: () => void;
	onSkip: () => void;
}

export const LocalSetupWizard = ({ onComplete, onSkip }: LocalSetupWizardProps) => {
	const accessor = useAccessor();
	const localSetupService = accessor.get('ILocalSetupService');

	const [step, setStep] = useState<number>(0);
	const [state, setState] = useState<LocalSetupState>(localSetupService.state);
	const [systemCheck, setSystemCheck] = useState<any>(null);
	const [selectedPack, setSelectedPack] = useState<ModelPackType>('balanced');
	const [verificationResults, setVerificationResults] = useState<any>(null);

	useEffect(() => {
		const disposable = localSetupService.onDidChangeState((newState) => {
			setState(newState);
		});
		return () => disposable.dispose();
	}, [localSetupService]);

	// Step 0: Choice
	const handleChoice = async (choice: 'local' | 'cloud' | 'later') => {
		if (choice === 'local') {
			localSetupService.startWizard();
			const checkResult = await localSetupService.checkSystem();
			setSystemCheck(checkResult);
			setStep(1);
		} else if (choice === 'cloud') {
			setStep(7); // Skip to regular onboarding
		} else {
			onSkip();
		}
	};

	// Step 1: System Check
	const handleInstallOllama = async () => {
		try {
			await localSetupService.installOllama();
			// Re-check system after install
			const checkResult = await localSetupService.checkSystem();
			setSystemCheck(checkResult);
			if (checkResult.ollamaRunning) {
				setStep(2);
			}
		} catch (error) {
			console.error('Install failed:', error);
		}
	};

	// Step 2: Model Pack Selection
	const handleSelectPack = (packType: ModelPackType) => {
		setSelectedPack(packType);
	};

	const handleDownloadModels = async () => {
		try {
			await localSetupService.downloadModelPack(selectedPack);
			setStep(3);
		} catch (error) {
			console.error('Download failed:', error);
		}
	};

	// Step 3: Verification
	const handleVerify = async () => {
		try {
			const results = await localSetupService.verifyCapabilities();
			setVerificationResults(results);
			setStep(4);
		} catch (error) {
			console.error('Verification failed:', error);
		}
	};

	// Step 4: Set Defaults
	const handleSetDefaults = async () => {
		try {
			await localSetupService.setDefaults(selectedPack);
			setStep(5);
		} catch (error) {
			console.error('Set defaults failed:', error);
		}
	};

	const handleCancel = () => {
		localSetupService.cancel();
		onSkip();
	};

	const progress = localSetupService.getProgress();

	return (
		<ErrorBoundary>
			<div className="w-full max-w-4xl mx-auto p-8">
				{/* Progress Bar */}
				<div className="mb-8">
					<div className="flex items-center justify-between mb-2">
						<span className="text-sm text-void-fg-3">Step {progress.currentStep} of {progress.totalSteps}</span>
						{progress.canCancel && (
							<button
								onClick={handleCancel}
								className="text-sm text-void-fg-3 hover:text-void-fg-1"
							>
								Cancel
							</button>
						)}
					</div>
					<div className="w-full bg-void-bg-3 rounded-full h-2">
						<div
							className="bg-gradient-to-r from-[#0e70c0] to-[#6b5bff] h-2 rounded-full transition-all duration-300"
							style={{ width: `${(progress.currentStep / progress.totalSteps) * 100}%` }}
						/>
					</div>
				</div>

				{/* Step Content */}
				<div className="rounded-[32px] border border-void-border-3 bg-void-bg-2/70 backdrop-blur-xl shadow-[0_45px_120px_rgba(0,0,0,0.45)] p-8">
					{step === 0 && <ChoiceStep onChoice={handleChoice} />}
					{step === 1 && systemCheck && <SystemCheckStep systemCheck={systemCheck} onInstall={handleInstallOllama} onNext={() => setStep(2)} />}
					{step === 2 && <ModelPackStep selectedPack={selectedPack} onSelect={handleSelectPack} onDownload={handleDownloadModels} state={state} />}
					{step === 3 && <VerificationStep onVerify={handleVerify} state={state} />}
					{step === 4 && verificationResults && <VerificationResultsStep results={verificationResults} onNext={handleSetDefaults} />}
					{step === 5 && <DefaultsStep onComplete={onComplete} />}
				</div>
			</div>
		</ErrorBoundary>
	);
};

const ChoiceStep = ({ onChoice }: { onChoice: (choice: 'local' | 'cloud' | 'later') => void }) => {
	return (
		<div className="space-y-6">
			<div className="text-center space-y-4">
				<h2 className="text-4xl font-light text-void-fg-0">Choose your setup</h2>
				<p className="text-void-fg-3 max-w-2xl mx-auto">
					Get started with CortexIDE. Choose local models for privacy, or use cloud providers.
				</p>
			</div>

			<div className="grid gap-4 mt-8">
				<button
					onClick={() => onChoice('local')}
					className="p-6 rounded-2xl border-2 border-void-border-2 bg-void-bg-3/60 hover:border-[#0e70c0] hover:bg-void-bg-3 transition-all text-left"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-xl font-medium text-void-fg-0 mb-2">Use local models (no API keys)</h3>
							<p className="text-void-fg-3">Run models on your computer for complete privacy. We'll help you set up Ollama.</p>
						</div>
						<ChevronRight className="w-6 h-6 text-void-fg-3" />
					</div>
				</button>

				<button
					onClick={() => onChoice('cloud')}
					className="p-6 rounded-2xl border border-void-border-3 bg-void-bg-3/40 hover:border-void-border-2 transition-all text-left"
				>
					<div className="flex items-center justify-between">
						<div>
							<h3 className="text-xl font-medium text-void-fg-0 mb-2">Use cloud provider</h3>
							<p className="text-void-fg-3">Connect to Anthropic, OpenAI, or other cloud providers with API keys.</p>
						</div>
						<ChevronRight className="w-6 h-6 text-void-fg-3" />
					</div>
				</button>

				<button
					onClick={() => onChoice('later')}
					className="p-4 rounded-2xl border border-void-border-4 bg-transparent hover:bg-void-bg-3/20 transition-all text-center"
				>
					<span className="text-void-fg-3">Decide later</span>
				</button>
			</div>
		</div>
	);
};

const SystemCheckStep = ({ systemCheck, onInstall, onNext }: { systemCheck: any; onInstall: () => void; onNext: () => void }) => {
	return (
		<div className="space-y-6">
			<h2 className="text-3xl font-light text-void-fg-0 mb-4">System Check</h2>

			<div className="space-y-4">
				<CheckItem
					label="Ollama installed"
					status={systemCheck.ollamaInstalled ? 'pass' : 'fail'}
				/>
				<CheckItem
					label="Ollama running"
					status={systemCheck.ollamaRunning ? 'pass' : 'fail'}
				/>
				{systemCheck.diskSpaceGb !== null && (
					<CheckItem
						label={`Disk space: ${systemCheck.diskSpaceGb.toFixed(1)} GB available`}
						status={systemCheck.diskSpaceGb > 10 ? 'pass' : 'warn'}
					/>
				)}
			</div>

			<div className="flex gap-4 mt-8">
				{!systemCheck.ollamaInstalled && (
					<button
						onClick={onInstall}
						className="px-6 py-3 rounded-2xl bg-gradient-to-r from-[#0e70c0] to-[#6b5bff] text-white font-medium"
					>
						Install Ollama
					</button>
				)}
				{systemCheck.ollamaRunning && (
					<button
						onClick={onNext}
						className="px-6 py-3 rounded-2xl border border-void-border-2 bg-void-bg-3 text-void-fg-0 font-medium"
					>
						Next
					</button>
				)}
			</div>
		</div>
	);
};

const CheckItem = ({ label, status }: { label: string; status: 'pass' | 'fail' | 'warn' }) => {
	return (
		<div className="flex items-center gap-3 p-4 rounded-xl border border-void-border-3 bg-void-bg-3/40">
			{status === 'pass' && <Check className="w-5 h-5 text-emerald-400" />}
			{status === 'fail' && <X className="w-5 h-5 text-rose-500" />}
			{status === 'warn' && <AlertCircle className="w-5 h-5 text-amber-400" />}
			<span className="text-void-fg-1">{label}</span>
		</div>
	);
};

const ModelPackStep = ({ selectedPack, onSelect, onDownload, state }: { selectedPack: ModelPackType; onSelect: (pack: ModelPackType) => void; onDownload: () => void; state: LocalSetupState }) => {
	const packs = getAllModelPacks();
	const isDownloading = state.type === 'downloading';

	return (
		<div className="space-y-6">
			<h2 className="text-3xl font-light text-void-fg-0 mb-4">Choose a model pack</h2>
			<p className="text-void-fg-3 mb-6">Select a pre-configured set of models optimized for different use cases.</p>

			<div className="grid gap-4">
				{packs.map((pack) => (
					<button
						key={pack.id}
						onClick={() => onSelect(pack.id as ModelPackType)}
						className={`p-6 rounded-2xl border-2 text-left transition-all ${
							selectedPack === pack.id
								? 'border-[#0e70c0] bg-void-bg-3/80'
								: 'border-void-border-3 bg-void-bg-3/40 hover:border-void-border-2'
						}`}
					>
						<div className="flex items-start justify-between">
							<div className="flex-1">
								<div className="flex items-center gap-2 mb-2">
									<h3 className="text-xl font-medium text-void-fg-0">{pack.name}</h3>
									{pack.id === 'balanced' && (
										<span className="px-2 py-1 text-xs bg-[#0e70c0]/20 text-[#0e70c0] rounded">Recommended</span>
									)}
								</div>
								<p className="text-void-fg-3 mb-3">{pack.description}</p>
								<div className="flex gap-4 text-sm text-void-fg-4">
									<span>~{pack.estimatedSizeGb} GB</span>
									<span>{pack.minRamGb}+ GB RAM</span>
								</div>
							</div>
							{selectedPack === pack.id && <Check className="w-5 h-5 text-[#0e70c0]" />}
						</div>
					</button>
				))}
			</div>

			{isDownloading && state.type === 'downloading' && (
				<div className="mt-6 p-4 rounded-xl border border-void-border-3 bg-void-bg-3/40">
					<div className="flex items-center gap-3 mb-2">
						<Loader2 className="w-5 h-5 text-[#0e70c0] animate-spin" />
						<span className="text-void-fg-1">Downloading {state.currentModel}...</span>
					</div>
					<div className="w-full bg-void-bg-1 rounded-full h-2">
						<div
							className="bg-[#0e70c0] h-2 rounded-full transition-all"
							style={{ width: `${(state.progress / state.totalModels) * 100}%` }}
						/>
					</div>
					<span className="text-sm text-void-fg-4 mt-2">
						{state.progress} of {state.totalModels} models
					</span>
				</div>
			)}

			<button
				onClick={onDownload}
				disabled={isDownloading}
				className="w-full mt-6 px-6 py-3 rounded-2xl bg-gradient-to-r from-[#0e70c0] to-[#6b5bff] text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{isDownloading ? 'Downloading...' : 'Download Models'}
			</button>
		</div>
	);
};

const VerificationStep = ({ onVerify, state }: { onVerify: () => void; state: LocalSetupState }) => {
	const isVerifying = state.type === 'verifying';

	return (
		<div className="space-y-6">
			<h2 className="text-3xl font-light text-void-fg-0 mb-4">Verifying Capabilities</h2>
			<p className="text-void-fg-3 mb-6">Testing that your local models work correctly.</p>

			{isVerifying && state.type === 'verifying' && (
				<div className="space-y-4">
					<div className="p-4 rounded-xl border border-void-border-3 bg-void-bg-3/40">
						<div className="flex items-center gap-3">
							<Loader2 className="w-5 h-5 text-[#0e70c0] animate-spin" />
							<span className="text-void-fg-1">Testing {state.currentTest}...</span>
						</div>
					</div>
				</div>
			)}

			{!isVerifying && (
				<button
					onClick={onVerify}
					className="w-full mt-6 px-6 py-3 rounded-2xl bg-gradient-to-r from-[#0e70c0] to-[#6b5bff] text-white font-medium"
				>
					Run Verification
				</button>
			)}
		</div>
	);
};

const VerificationResultsStep = ({ results, onNext }: { results: any; onNext: () => void }) => {
	return (
		<div className="space-y-6">
			<h2 className="text-3xl font-light text-void-fg-0 mb-4">Verification Results</h2>

			<div className="space-y-3">
				<ResultItem label="Chat" passed={results.chat.passed} error={results.chat.error} />
				<ResultItem label="Tool Calling" passed={results.toolCalling.passed} error={results.toolCalling.error} />
				<ResultItem
					label="Web Calling"
					passed={results.webCalling.passed}
					skipped={results.webCalling.skipped}
					error={results.webCalling.error}
				/>
			</div>

			<button
				onClick={onNext}
				className="w-full mt-6 px-6 py-3 rounded-2xl bg-gradient-to-r from-[#0e70c0] to-[#6b5bff] text-white font-medium"
			>
				Continue
			</button>
		</div>
	);
};

const ResultItem = ({ label, passed, skipped, error }: { label: string; passed: boolean; skipped?: boolean; error?: string }) => {
	return (
		<div className="flex items-center gap-3 p-4 rounded-xl border border-void-border-3 bg-void-bg-3/40">
			{passed && <Check className="w-5 h-5 text-emerald-400" />}
			{!passed && !skipped && <X className="w-5 h-5 text-rose-500" />}
			{skipped && <AlertCircle className="w-5 h-5 text-void-fg-4" />}
			<div className="flex-1">
				<span className="text-void-fg-1">{label}</span>
				{skipped && <span className="text-void-fg-4 ml-2">(skipped)</span>}
				{error && <span className="text-rose-500 ml-2 text-sm">({error})</span>}
			</div>
		</div>
	);
};

const DefaultsStep = ({ onComplete }: { onComplete: () => void }) => {
	return (
		<div className="space-y-6 text-center">
			<Check className="w-16 h-16 text-emerald-400 mx-auto mb-4" />
			<h2 className="text-3xl font-light text-void-fg-0 mb-4">Setup Complete!</h2>
			<p className="text-void-fg-3 mb-8 max-w-2xl mx-auto">
				Your local models are configured and ready to use. CortexIDE will use local models by default.
			</p>
			<button
				onClick={onComplete}
				className="px-8 py-4 rounded-2xl bg-gradient-to-r from-[#0e70c0] to-[#6b5bff] text-white font-medium text-lg"
			>
				Start using CortexIDE
			</button>
		</div>
	);
};

