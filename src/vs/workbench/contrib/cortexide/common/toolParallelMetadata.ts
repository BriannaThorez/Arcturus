/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Part E: Tool Parallel Execution Metadata
 *
 * Defines which tools can be executed in parallel safely.
 * Tools that read-only or operate on different resources can often run in parallel.
 */

import type { BuiltinToolName } from './toolsServiceTypes.js';

export interface ToolParallelMetadata {
	parallelSafe: boolean; // Can this tool run in parallel with other tools?
	maxConcurrency?: number; // Maximum concurrent instances of this tool (default: unlimited if parallelSafe)
}

/**
 * Metadata for built-in tools regarding parallel execution safety.
 *
 * Rules:
 * - Read-only tools (read_file, search_*, ls_dir, etc.) are generally parallel-safe
 * - Write tools (edit_file, rewrite_file, delete_file) are NOT parallel-safe (can conflict)
 * - Terminal commands are NOT parallel-safe (shared terminal state)
 * - Web tools (web_search, browse_url) are parallel-safe (different URLs)
 */
export const builtinToolParallelMetadata: Partial<Record<BuiltinToolName, ToolParallelMetadata>> = {
	// Read-only file operations - safe to parallelize
	'read_file': { parallelSafe: true, maxConcurrency: 10 },
	'search_for_files': { parallelSafe: true, maxConcurrency: 5 },
	'search_in_file': { parallelSafe: true, maxConcurrency: 10 },
	'search_pathnames_only': { parallelSafe: true, maxConcurrency: 5 },
	'ls_dir': { parallelSafe: true, maxConcurrency: 10 },
	'get_dir_tree': { parallelSafe: true, maxConcurrency: 5 },
	'read_lint_errors': { parallelSafe: true, maxConcurrency: 10 },

	// Write operations - NOT parallel-safe (can conflict on same file)
	'edit_file': { parallelSafe: false },
	'rewrite_file': { parallelSafe: false },
	'create_file_or_folder': { parallelSafe: false },
	'delete_file_or_folder': { parallelSafe: false },

	// Terminal operations - NOT parallel-safe (shared terminal state)
	'run_command': { parallelSafe: false },
	'run_nl_command': { parallelSafe: false },
	'run_persistent_command': { parallelSafe: false },
	'open_persistent_terminal': { parallelSafe: false },
	'kill_persistent_terminal': { parallelSafe: false },

	// Web operations - parallel-safe (different URLs)
	'web_search': { parallelSafe: true, maxConcurrency: 3 },
	'browse_url': { parallelSafe: true, maxConcurrency: 5 },
};

/**
 * Get parallel metadata for a tool
 */
export function getToolParallelMetadata(toolName: string): ToolParallelMetadata {
	const metadata = builtinToolParallelMetadata[toolName as BuiltinToolName];
	if (metadata) {
		return metadata;
	}
	// Default: not parallel-safe (conservative)
	return { parallelSafe: false };
}

/**
 * Check if a tool is safe to run in parallel
 */
export function isToolParallelSafe(toolName: string): boolean {
	return getToolParallelMetadata(toolName).parallelSafe;
}

/**
 * Get max concurrency for a tool
 */
export function getToolMaxConcurrency(toolName: string): number | undefined {
	return getToolParallelMetadata(toolName).maxConcurrency;
}

