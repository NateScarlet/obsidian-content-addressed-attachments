import { sveltePreprocess } from "svelte-preprocess";

/**@type {import('@sveltejs/kit').Config} */
export default {
	compilerOptions: { css: "injected", runes: true },
	preprocess: sveltePreprocess(),
};
