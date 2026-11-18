import { createRoot } from 'react-dom/client';
import './styles.css';
import { takeTokenFromAddress } from './api';
import { App } from './app';

takeTokenFromAddress();

// Light or dark follows the system. The controls from ./ui switch on the same attribute.
const dark = matchMedia('(prefers-color-scheme: dark)');
const setTheme = () => {
  document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light';
};
setTheme();
dark.addEventListener('change', setTheme);

createRoot(document.getElementById('root')!).render(<App />);
