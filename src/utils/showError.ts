import { Notice } from "obsidian";
import castError from "./castError";
import isAbortError from "./isAbortError";

export default function showError(err: unknown) {
	if (isAbortError(err)) {
		return;
	}
	const msg = castError(err).message;
	new Notice(msg);
}
