import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

if (new URLSearchParams(location.search).has('webgltest')) {
  import('./webgl-parity-test').then((m) => m.runWebglParityTest())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
