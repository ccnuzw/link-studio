export function focusOnMount(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
}
