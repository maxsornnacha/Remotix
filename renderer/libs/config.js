export const getApiBaseUrl = () => {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  // Safe fallback for local dev when env is missing.
  if (!apiUrl) return "http://localhost:3000";
  return apiUrl;
};
