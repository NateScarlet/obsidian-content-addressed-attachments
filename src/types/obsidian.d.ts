import type { KeyStorage } from "#src/lib/encryption/types";

declare module "obsidian" {
	interface App {
		secretStorage?: KeyStorage;
	}
}
