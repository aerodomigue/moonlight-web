import { t } from '../i18n/i18n.js';
import { frontendBuild } from './FrontendBuild.js';

export function showBuildIdentity(element, serverVersion, build = frontendBuild) {
    if (!element) return;
    const revision = /^[a-f0-9]{40,64}$/.test(build.revision) ? build.revision : '';
    const ui = revision
        ? revision.slice(0, 8) + (build.dirty ? ' + ' + t('header.buildModified') : '')
        : t('header.buildUnknown');
    element.textContent = t('header.frontendBuild') + ' ' + ui;
    if (serverVersion)
        element.textContent += ' · ' + t('header.backendBuild') + ' v' + serverVersion;
    element.title = t('header.frontendBuild') + ': ' + (revision || t('header.buildUnknown'));
    if (build.dirty) element.title += ' (' + t('header.buildModified') + ')';
    if (serverVersion) element.title += '\n' + t('header.backendBuild') + ': v' + serverVersion;
    element.hidden = false;
}
