/**
 * FAMAX — Toggle Switch (Shared)
 * Inicializa todos os toggle switches na página.
 * Opcionalmente aceita um callback para quando o toggle muda de estado.
 */
export function initToggleSwitches(
    onChange?: (element: HTMLElement, isOn: boolean) => void
): void {
    const toggleSwitches =
        document.querySelectorAll<HTMLElement>(".toggle-switch-ui");

    toggleSwitches.forEach((toggleSwitch) => {
        toggleSwitch.addEventListener("click", () => {
            toggleSwitch.classList.toggle("on");

            if (onChange) {
                const isOn = toggleSwitch.classList.contains("on");
                onChange(toggleSwitch, isOn);
            }
        });
    });
}
