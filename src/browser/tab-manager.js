import { createTab } from 'src/browser/tab.js';

export function createTabManager(tui, theme) {
  const tabs = [];
  let activeIndex = -1;

  function add(url = '') {
    const tab = createTab(tui, theme);
    if (url) tab.omnibox.setText(url);
    tabs.push(tab);
    activeIndex = tabs.length - 1;
    return tab;
  }

  function remove(index) {
    if (index < 0 || index >= tabs.length) return false;
    tabs.splice(index, 1);
    if (tabs.length === 0) { activeIndex = -1; return true; }
    if (activeIndex >= tabs.length) activeIndex = tabs.length - 1;
    if (activeIndex > index) activeIndex--;
    return true;
  }

  function activate(index) {
    if (index >= 0 && index < tabs.length) { activeIndex = index; return true; }
    return false;
  }

  function active() { return tabs[activeIndex] || null; }
  function getById(id) { return tabs.find(t => t.id === id) || null; }
  function indexOf(id) { return tabs.findIndex(t => t.id === id); }

  return {
    add, remove, activate, active, getById, indexOf,
    list: () => tabs,
    activeIndex: () => activeIndex,
    count: () => tabs.length,
  };
}
