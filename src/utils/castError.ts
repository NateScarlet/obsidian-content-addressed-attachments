export default function castError(err: unknown): Error {
	if (err instanceof Error) {
		return err;
	}
	return new Error(String(err));
}
