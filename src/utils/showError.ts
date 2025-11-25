import { Notice } from "obsidian";
import castError from "./castError";

export default function showError(err: unknown) {
	const msg = castError(err).message;
	new Notice(msg);
}
