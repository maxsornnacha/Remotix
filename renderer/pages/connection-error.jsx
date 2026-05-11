import { useMemo } from 'react'
import { useRouter } from 'next/router'
import { useTheme } from '../libs/theme'

const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return ''
}

export default function ConnectionErrorPage() {
  const router = useRouter()
  const { isDark, toggleTheme } = useTheme()

  const message = useMemo(
    () => toText(router.query?.message) || 'Connection failed.',
    [router.query],
  )
  const detail = useMemo(
    () => toText(router.query?.detail),
    [router.query],
  )

  return (
    <div className={`min-h-screen px-6 py-10 ${isDark ? 'bg-[#0b1020] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={toggleTheme}
            className={`rounded-md border px-3 py-1.5 text-xs ${
              isDark ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-300 bg-white text-slate-700'
            }`}
          >
            {isDark ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
        <div className={`rounded-2xl border p-6 shadow-2xl ${
          isDark ? 'border-red-400/30 bg-[#101a2f]' : 'border-red-300 bg-white'
        }`}>
        <p className={`text-xs uppercase tracking-[0.14em] ${isDark ? 'text-red-300' : 'text-red-600'}`}>Connection Error</p>
        <h1 className={`mt-2 text-2xl font-semibold ${isDark ? 'text-red-100' : 'text-red-700'}`}>{message}</h1>
        {detail ? (
          <p className={`mt-3 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{detail}</p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => router.push('/home')}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            Back to Home
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className={`rounded-md border px-4 py-2 text-sm ${
              isDark
                ? 'border-slate-500 text-slate-200 hover:bg-slate-800'
                : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}
          >
            Go Back
          </button>
        </div>
      </div>
      </div>
    </div>
  )
}
