import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './utils/installPrompt'; // starts listening for beforeinstallprompt as early as possible — see its own comment
import './styles/global.css';
import './styles/calendar.css';
import './styles/gantt.css';
import './styles/board.css';
import './styles/nav.css';
import './styles/tasklist.css';
import './styles/stats.css';
import './styles/forms.css';
import './styles/dashboard.css';
import './styles/tutorial.css';
import './styles/timer.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
