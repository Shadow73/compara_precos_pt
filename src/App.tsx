import { useState } from 'react';
import SearchBox from './components/SearchBox';
import PriceTable from './components/PriceTable';
import Basket from './components/Basket';
import type { SearchResponse } from './types';
import { API_BASE } from './config';

export default function App() {
  const [tab, setTab] = useState<'comparar' | 'cesta'>('comparar');
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
        <p className="rj">By RJCod3</p>
      </header>

      <nav className="tabs">
        <button
          className={tab === 'comparar' ? 'active' : ''}
          onClick={() => setTab('comparar')}
        >
          🔍 Comparar produto
        </button>
        <button
          className={tab === 'cesta' ? 'active' : ''}
          onClick={() => setTab('cesta')}
        >
          🧺 Lista de compras
        </button>
      </nav>

      {tab === 'comparar' ? (
        <>
          <SearchBox onSearch={handleSearch} loading={loading} />

          {fatalError && <div className="error-banner">⚠️ {fatalError}</div>}
          {loading && <div className="loading">A pesquisar em todas as superfícies…</div>}

          {data && !loading && <PriceTable data={data} />}
        </>
      ) : (
        <Basket />
      )}
    </div>
  );
}
