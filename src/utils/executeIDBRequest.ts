import createEventListeners from "./createEventListeners";

export default async function executeIDBRequest<T>(
	request: IDBRequest<T>,
): Promise<T> {
	if (request.readyState === "done") {
		if (request.error) {
			throw request.error;
		}
		return request.result;
	}
	using stack = new DisposableStack();
	return await new Promise((resolve, reject) => {
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
						reject(request.error);
					},
					{ once: true },
				);
			}),
		);
	});
}
