import { Notice } from "obsidian";
import ButtonNotice from "src/lib/ButtonNotice.svelte";
import { mount, unmount, type ComponentProps } from "svelte";

export default function showButton(props: ComponentProps<typeof ButtonNotice>) {
	const fragment = new DocumentFragment();
	const component = mount(ButtonNotice, {
		target: fragment.createDiv(),
		props,
	});
	const notice = new Notice(fragment, 0);
	return () => {
		notice.hide();
		void unmount(component);
	};
}
