import { createContext, useContext } from 'react'

export const AlertContext = createContext({
  pushAlert: () => {},
})

export const useAlerts = () => useContext(AlertContext)

