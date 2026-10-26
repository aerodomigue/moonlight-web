import { t } from '../i18n/i18n.js';

/** Moves existing controls, preserving draft values and handlers across tab changes. */
export class SettingsTabs {
    constructor(root, definitions, selected, onChange = () => {}) {
        this.root = root;
        this.panels = new Map();
        this.buttons = new Map();
        this.onChange = onChange;
        const nav = document.createElement('div');
        nav.className = 'settings-tabs';
        nav.setAttribute('role', 'tablist');
        nav.setAttribute('aria-label', t('settingsTabs.navigation'));
        root.querySelector(':scope > div').after(nav);
        for (const key of definitions) {
            const nodes = [...root.querySelectorAll(`:scope > [data-settings-tab="${key}"]`)];
            if (!nodes.length) continue;
            const panel = document.createElement('div');
            panel.id = `${root.id}-panel-${key}`;
            panel.setAttribute('role', 'tabpanel');
            const button = document.createElement('button');
            button.type = 'button';
            button.id = `${root.id}-tab-${key}`;
            button.textContent = t(`settingsTabs.${key}`);
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', panel.id);
            panel.setAttribute('aria-labelledby', button.id);
            button.addEventListener('click', () => this.select(key));
            button.addEventListener('keydown', (event) => {
                const keys = [...this.buttons.keys()];
                const index = keys.indexOf(key);
                let next;
                if (event.key === 'ArrowRight') next = keys[(index + 1) % keys.length];
                if (event.key === 'ArrowLeft') next = keys[(index + keys.length - 1) % keys.length];
                if (event.key === 'Home') next = keys[0];
                if (event.key === 'End') next = keys.at(-1);
                if (!next) return;
                event.preventDefault();
                this.select(next);
                this.buttons.get(next).focus();
            });
            nav.append(button);
            panel.append(...nodes);
            root.append(panel);
            this.buttons.set(key, button);
            this.panels.set(key, panel);
        }
        this.select(this.panels.has(selected) ? selected : this.panels.keys().next().value);
    }

    select(key) {
        if (!this.panels.has(key)) return;
        for (const [name, panel] of this.panels) {
            panel.hidden = name !== key;
            const button = this.buttons.get(name);
            button.setAttribute('aria-selected', String(name === key));
            button.tabIndex = name === key ? 0 : -1;
        }
        this.onChange(key);
    }
}

/** Split mixed legacy sections before mounting tabs; keep every original control. */
export function moveSettingsFields(root, selectors, tab) {
    const section = document.createElement('section');
    section.className = 'settings-section';
    section.dataset.settingsTab = tab;
    const title = document.createElement('h3');
    title.className = 'settings-section-title';
    title.textContent = t(`settingsTabs.${tab}`);
    section.append(title);
    for (const selector of selectors) {
        const field = root.querySelector(selector)?.closest('.settings-field');
        if (field) section.append(field);
    }
    if (section.children.length > 1) root.append(section);
}
