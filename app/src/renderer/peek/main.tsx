import React from 'react'
import { createRoot } from 'react-dom/client'
import Peek from './Peek'
import './peek.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Peek />
  </React.StrictMode>
)
