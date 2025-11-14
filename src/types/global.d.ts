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
		startIn?: FileSystemFileHandle | string;
		types?: { accept: Record<string, string[]>; description?: string }[];
	}): Promise<FileSystemFileHandle[]>;
}
