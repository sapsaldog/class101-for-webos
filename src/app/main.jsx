import './polyfills.js';
import { render } from 'preact';
import App from './App.jsx';
import { warmUp } from './api.js';
import './styles.css';
import './overlay.css';

warmUp();
render(<App />, document.getElementById('app'));
