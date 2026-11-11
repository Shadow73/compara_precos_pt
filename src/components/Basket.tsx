import { useState } from 'react';
import { API_BASE } from '../config';

interface CheapestOffer {
  price: number;
  name: string;
  brand?: string;
  url?: string;
}

interface BasketItem {
  query: string;
  cheapest: Record<string, CheapestOffer>;
}

interface SummaryRow {
  supermarket: string;
  total: number;
  count: number;
  totalItems: number;
  missing: string[];
  /** true = a superfície tem TODOS os artigos da cesta */
  complete: boolean;
  isCheapest: boolean;
  diff: number | null;
  diffPct: number | null;
}

interface BasketResponse {
  items: BasketItem[];
  summary: SummaryRow[];
  cheapestSupermarket: string | null;
  errors: { supermarket: string; reason: string }[];
}

export default function Basket() {
  const [items, setItems] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const [result, setResult] = useState<BasketResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addItem(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (!items.some((i) => i.toLowerCase() === v.toLowerCase())) {
      setItems([...items, v]);
    }
    setValue('');
    setResult(null);
  }

  function removeItem(index: number) {
    setItems(items.filter((_, i) => i !== index));
    setResult(null);
  }

  async function compare() {
    if (items.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/basket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`Erro ${res.status} do servidor`);
      setResult((await res.json()) as BasketResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // A tabela principal mostra apenas superfícies com TODOS os artigos
  // da cesta — as parciais (1/3, 2/3, …) não são comparáveis.
  const completeRows = result?.summary.filter((s) => s.complete) ?? [];
  const partialRows = result?.summary.filter((s) => !s.complete) ?? [];
  const cheapestRow = result?.summary.find((s) => s.isCheapest);

  return (
    <section className="basket">
      <form className="search-box" onSubmit={addItem}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Adicione um artigo: arroz agulha, leite meio gordo, café…"
        />
        <button type="submit" disabled={!value.trim()}>
          Adicionar
        </button>
      </form>

      {items.length > 0 && (
        <ul className="basket-items">
          {items.map((item, i) => (
            <li key={`${item}-${i}`}>
              <span>{item}</span>
              <button
                className="remove"
                onClick={() => removeItem(i)}
                aria-label={`Remover ${item}`}
                title="Remover"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <button className="compare-btn" onClick={compare} disabled={loading}>
          {loading
            ? `A comparar ${items.length} ${items.length === 1 ? 'artigo' : 'artigos'}…`
            : `Comparar cesta (${items.length} ${items.length === 1 ? 'artigo' : 'artigos'})`}
        </button>
      )}

      {error && <div className="error-banner">⚠️ {error}</div>}

      {result && !loading && (
        <>
          {result.cheapestSupermarket ? (
            <div className="basket-verdict">
              🏆 <strong>{result.cheapestSupermarket}</strong> é a superfície
              mais barata com todos os {cheapestRow?.totalItems}{' '}
              {cheapestRow?.totalItems === 1 ? 'artigo' : 'artigos'} da cesta (
              {cheapestRow?.total.toFixed(2)} €)
            </div>
          ) : (
            <div className="warnings">
              <div className="warning">
                ⚠️ Nenhuma superfície tem todos os artigos desta cesta — não é
                possível comparar a cesta completa. Veja abaixo onde comprar
                cada artigo mais barato.
              </div>
            </div>
          )}

          {completeRows.length > 0 && (
            <table className="price-table basket-table">
              <thead>
                <tr>
                  <th>Superfície</th>
                  <th>Artigos</th>
                  <th className="num">Total da cesta</th>
                  <th className="num">Diferença</th>
                </tr>
              </thead>
              <tbody>
                {completeRows.map((s) => (
                  <tr key={s.supermarket} className={s.isCheapest ? 'cheapest' : ''}>
                    <td>
                      {s.supermarket}
                      {s.isCheapest && <span className="best-tag">mais barata</span>}
                    </td>
                    <td>
                      {s.count}/{s.totalItems}
                      {s.missing.length > 0 && (
                        <div className="missing">em falta: {s.missing.join(', ')}</div>
                      )}
                    </td>
                    <td className="num price">{s.total.toFixed(2)} €</td>
                    <td className="num">
                      {s.isCheapest ? '—' : `+${s.diff?.toFixed(2)} € (+${s.diffPct}%)`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {partialRows.length > 0 && (
            <div className="partial-box">
              <h4>Fora da comparação — sem todos os artigos</h4>
              <ul>
                {partialRows.map((s) => (
                  <li key={s.supermarket}>
                    <strong>{s.supermarket}</strong> — {s.count}/{s.totalItems}{' '}
                    {s.totalItems === 1 ? 'artigo' : 'artigos'}
                    {s.missing.length > 0 && (
                      <> · em falta: {s.missing.join(', ')}</>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="basket-subtitle">Onde comprar cada artigo mais barato</h3>
          <table className="price-table">
            <thead>
              <tr>
                <th>Artigo</th>
                <th>Superfície</th>
                <th>Produto</th>
                <th className="num">Preço</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => {
                const entries = Object.entries(item.cheapest).sort(
                  (a, b) => a[1].price - b[1].price,
                );
                if (entries.length === 0) {
                  return (
                    <tr key={item.query}>
                      <td>{item.query}</td>
                      <td colSpan={3}>sem resultados</td>
                    </tr>
                  );
                }
                const [bestName, best] = entries[0];
                return (
                  <tr key={item.query}>
                    <td>{item.query}</td>
                    <td>{bestName}</td>
                    <td>
                      {best.url ? (
                        <a href={best.url} target="_blank" rel="noreferrer">
                          {best.name}
                        </a>
                      ) : (
                        best.name
                      )}
                    </td>
                    <td className="num price">{best.price.toFixed(2)} €</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
