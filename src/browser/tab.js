import { createOmnibox }  from 'src/ui/omnibox.js';
import { createPageView } from 'src/ui/page-view.js';
import { createHistory }  from 'src/browser/history.js';

let nextTabId = 1;

export function createTab(tui, theme, imageView) {
  return {
    id: nextTabId++,
    omnibox:   createOmnibox(),
    pageView:  createPageView(tui, theme, imageView),
    history:   createHistory(),
    currentUrl: '',
    mode: 'omnibox',
    statusText: 'New Tab',
    loading: false,
  };
}
