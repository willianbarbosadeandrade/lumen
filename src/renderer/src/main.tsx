import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { Bar } from './views/Bar'
import { Home } from './views/Home'
import { Onboarding } from './views/Onboarding'

const route = window.location.hash.replace(/^#\/?/, '') || 'home'
document.documentElement.dataset.view = route === 'bar' ? 'bar' : 'app'
document.documentElement.dataset.platform = window.lumen?.platform ?? 'darwin'

function Root() {
  if (route === 'bar') return <Bar />
  if (route === 'onboarding') return <Onboarding />
  return <Home initial={route} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
