import React from 'react'
import { createRoot } from 'react-dom/client'
import Peek from './Peek'
import { watchAccent } from '../shared/accent'
import './peek.css'

watchAccent()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Peek />
  </React.StrictMode>,
)
