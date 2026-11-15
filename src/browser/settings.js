const DEFAULTS = {
  homepage:     '',
  searchEngine: 'duckduckgo',
  showImages:   true,
  acceptCookies: true,
};

const SEARCH_ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  google:     { label: 'Google',     url: 'https://www.google.com/search?q=%s' },
  bing:       { label: 'Bing',       url: 'https://www.bing.com/search?q=%s' },
  wikipedia:  { label: 'Wikipedia',  url: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' },
};

const HOMEPAGES = [
  { label: 'New Tab',      value: '' },
  { label: 'DuckDuckGo',   value: 'https://duckduckgo.com/' },
  { label: 'Google',       value: 'https://www.google.com/' },
  { label: 'Wikipedia',    value: 'https://en.wikipedia.org/' },
];

export function createSettings(fs) {
  const configDir    = fs ? fs.homeDir() + '/.config/qjsbrowser' : null;
  const settingsPath = configDir ? configDir + '/settings.json' : null;

  let data = { ...DEFAULTS };

  function load() {
    if (!settingsPath || !fs.exists(settingsPath)) return;
    try {
      const raw = fs.readFile(settingsPath);
      const parsed = JSON.parse(raw);
      data = { ...DEFAULTS, ...(parsed || {}) };
    } catch (_) { /* corrupt → keep defaults */ }
  }

  function save() {
    if (!settingsPath) return;
    try {
      fs.mkdirp(configDir);
      fs.writeFile(settingsPath, JSON.stringify(data, null, 2));
    } catch (_) {}
  }

  function get(key)         { return data[key]; }
  function set(key, value)  { data[key] = value; save(); }
  function all()            { return { ...data }; }

  return {
    load, save, get, set, all,
    get configDir() { return configDir; },
    SEARCH_ENGINES,
    HOMEPAGES,
  };
}
