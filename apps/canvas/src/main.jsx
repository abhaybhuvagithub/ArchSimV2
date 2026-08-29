import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { ToastHost } from './Toast.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastHost>
      <App />
    </ToastHost>
  </React.StrictMode>,
)
