import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import './styles/calendar.css';
import './styles/gantt.css';
import './styles/board.css';
import './styles/nav.css';
import './styles/tasklist.css';
import './styles/stats.css';
import './styles/forms.css';
import './styles/tutorial.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
