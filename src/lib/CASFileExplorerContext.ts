import { createContext } from "svelte";
import type { App } from "obsidian";
import type { CAS } from "#src/types/CAS";
import type { CASMetadata } from "#src/types/CASMetadata";
import type ReferenceManager from "#src/ReferenceManager";

export enum Mode {
	LOCAL,
	ACTIVE_NOTE,
	UNREFERENCED,
	RECYCLE_BIN,
}

export interface CASFileExplorerContext {
	// 依赖
	cas: CAS;
	casMetadata: CASMetadata;
	referenceManager: ReferenceManager;
	app: App;

	// 状态
	mode: { value: Mode };
	query: { value: string };

	fetchMore: (signal?: AbortSignal) => Promise<void>;
}

export const [getContext, setContext] = createContext<CASFileExplorerContext>();
