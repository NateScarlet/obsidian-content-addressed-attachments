type WellKnownDirectory =
	| "desktop"
	| "documents"
	| "downloads"
	| "music"
	| "pictures"
	| "videos";

interface Window {
	electron?: {
		shell?: {
			openPath(path: string): void;
			openExternal(url: string): void;
		};
	};
	/** https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker */
	showOpenFilePicker(options?: {
		excludeAcceptAllOption?: boolean;
		id?: string;
		multiple?: boolean;
		startIn?: FileSystemFileHandle | WellKnownDirectory;
		types?: { accept: Record<string, string[]>; description?: string }[];
	}): Promise<FileSystemFileHandle[]>;
	/** https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker */
	showSaveFilePicker(options?: {
		excludeAcceptAllOption?: boolean;
		id?: string;
		startIn?: FileSystemFileHandle | WellKnownDirectory;
		suggestedName?: string;
		types?: { accept: Record<string, string[]>; description?: string }[];
	}): Promise<FileSystemFileHandle>;
}
