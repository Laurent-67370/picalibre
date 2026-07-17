import React from 'react'
import ReactDOM from 'react-dom/client'

// Appliqué avant le rendu React pour éviter un flash du mauvais thème.
// 'clair' (inspiré de Picasa 3) est le défaut ; 'sombre' reste dispo dans
// Réglages pour qui préfère la palette navy/orange historique.
const savedTheme = localStorage.getItem('picalibre.theme')
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light'

import './styles.css'
import App from './App'

if (new URLSearchParams(location.search).has('webgltest')) {
  import('./webgl-parity-test').then((m) => m.runWebglParityTest())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
