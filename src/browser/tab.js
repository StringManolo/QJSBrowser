import { createOmnibox }    from 'src/ui/omnibox.js';
import { createPageView }   from 'src/ui/page-view.js';
import { createHistory }    from 'src/browser/history.js';
import { createFormState }  from 'src/browser/form-state.js';

let nextTabId = 1;

export function createTab(tui, theme, imageView) {
  const formState = createFormState();
  return {
    id: nextTabId++,
    omnibox:   createOmnibox(),
    pageView:  createPageView(tui, theme, imageView, formState),
    formState,
    history:   createHistory(),
    currentUrl: '',
    mode: 'omnibox',
    statusText: 'New Tab',
    loading: false,
    navId: 0,          /* bumped on every navigation; lets us drop stale async results */
  };
}
