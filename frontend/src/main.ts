import '@fontsource-variable/inter'
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { locale } from './i18n'
import { connect, reportError } from './telemetry/store'

document.documentElement.lang = locale.value

connect()
const app = createApp(App)
app.config.errorHandler = reportError
app.mount('#app')
