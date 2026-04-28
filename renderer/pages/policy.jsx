import Link from 'next/link'
import { useTheme } from '../libs/theme'

function ThemeGlyph({ isDark }) {
  if (isDark) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.2M12 19.8V22M4.22 4.22l1.56 1.56M18.22 18.22l1.56 1.56M2 12h2.2M19.8 12H22M4.22 19.78l1.56-1.56M18.22 5.78l1.56-1.56" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3c.5 0 .73.61.4 1A7 7 0 0 0 20 12.4c.39-.3 1 .02 1 .39Z" />
    </svg>
  )
}

export default function PolicyPage() {
  const { isDark, toggleTheme } = useTheme()

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0f0f0f] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className={`w-full min-h-screen p-6 md:p-8 space-y-6 overflow-y-auto ${isDark ? 'bg-[#1a1a1a]' : 'bg-white'}`}>
        <div className="flex items-center justify-between">
          <h1 className={`text-3xl font-bold ${isDark ? 'text-blue-500' : 'text-blue-700'}`}>Remote Access Policy</h1>
          <button
            type="button"
            onClick={toggleTheme}
            className={`text-xs px-3 py-1.5 rounded-md border ${isDark ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <ThemeGlyph isDark={isDark} />
          </button>
        </div>
        <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-slate-700'}`}>
          Remotix gives remote screen viewing and control. Use it only with clear consent from both host and client.
        </p>

        <ul className={`space-y-3 text-sm list-disc pl-5 ${isDark ? 'text-gray-300' : 'text-slate-700'}`}>
          <li>Share room IDs only with trusted users.</li>
          <li>Enable remote control only when necessary and disable it when finished.</li>
          <li>Do not access private or sensitive data without explicit permission.</li>
          <li>Disconnect the session immediately if behavior looks suspicious.</li>
        </ul>

        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-slate-500'}`}>
          By continuing in the app, you confirm you understand these rules and accept responsibility for session security.
        </p>

        <div>
          <Link href="/home" className="inline-block bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-md transition">
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  )
}
