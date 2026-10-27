import { useState } from 'react';
import SearchBox from './components/SearchBox';
import PriceTable from './components/PriceTable';
import type { SearchResponse } from './types';

// URL do backend: vazio em dev (o Vite faz proxy para localhost:3001);
// em produção aponta para o backend (ex.: https://meu-backend.onrender.com)
const API_BASE = import.meta.env.VITE_API_URL ?? '';

export default function App() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);

  async function handleSearch(term: string) {
    if (!term.trim()) return;
    setQuery(term);
    setLoading(true);
    setFatalError(null);
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(term)}`);
      if (!res.ok) throw new Error(`Erro ${res.status} do servidor`);
      const json: SearchResponse = await res.json();
      setData(json);
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : 'Erro desconhecido');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <header>
        <h1>🛒 Comparador de Preços</h1>
        <p className="subtitle">
          Compare preços de produtos alimentares entre supermercados portugueses
        </p>
      </header>

      <SearchBox onSearch={handleSearch} loading={loading} />

      {fatalError && <div className="error-banner">⚠️ {fatalError}</div>}
      {loading && <div className="loading">A pesquisar em todas as superfícies…</div>}

      {data && !loading && (
        <PriceTable data={data} />
      )}
    </div>
  );
}
