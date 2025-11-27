import castError from "./castError";
import createEventListeners from "./createEventListeners";

export default async function executeIDBRequest<T>(
	request: IDBRequest<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (request.readyState === "done") {
		if (request.error) {
			throw request.error;
		}
		return request.result;
	}
	signal?.throwIfAborted();
	using stack = new DisposableStack();
	return await new Promise((resolve, reject) => {
		if (signal) {
			stack.use(
				createEventListeners(signal, (ctx) => {
					ctx.on("abort", () => {
						try {
							signal.throwIfAborted();
						} catch (err) {
							reject(castError(err));
						}
					});
				}),
			);
		}
		stack.use(
			createEventListeners(request, (ctx) => {
				ctx.on(
					"success",
					() => {
						resolve(request.result);
					},
					{ once: true },
				);
				ctx.on(
					"error",
					() => {
						reject(castError(request.error));
					},
					{ once: true },
				);
			}),
		);
	});
}
