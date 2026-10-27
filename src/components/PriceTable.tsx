import { useMemo, useState } from 'react';
import type { SearchResponse, ProductOffer } from '../types';

type SortKey = 'price' | 'supermarket' | 'brand' | 'name';

const SUPERMARKET_COLORS: Record<string, string> = {
  'Continente': '#e30613',
  'Pingo Doce': '#ffcc00',
  'Auchan': '#e42313',
  'Intermarché': '#005baa',
  'Lidl': '#0050aa',
};

interface Props {
  data: SearchResponse;
}

export default function PriceTable({ data }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('price');

  const sorted = useMemo(() => {
    const offers = [...data.offers];
    offers.sort((a: ProductOffer, b: ProductOffer) => {
      if (sortKey === 'price') return a.price - b.price;
      return String(a[sortKey]).localeCompare(String(b[sortKey]), 'pt');
    });
    return offers;
  }, [data, sortKey]);

  const cheapest = useMemo(
    () => (data.offers.length ? Math.min(...data.offers.map((o) => o.price)) : null),
    [data],
  );

  return (
    <section>
      {data.errors.length > 0 && (
        <div className="warnings">
          {data.errors.map((e) => (
            <div key={e.supermarket} className="warning">
              ⚠️ <strong>{e.supermarket}</strong>: {e.reason}
            </div>
          ))}
        </div>
      )}

      {sorted.length === 0 ? (
        <p className="empty">Nenhum resultado encontrado para «{data.query}».</p>
      ) : (
        <table className="price-table">
          <thead>
            <tr>
              <th onClick={() => setSortKey('supermarket')}>Superfície ⬍</th>
              <th onClick={() => setSortKey('brand')}>Marca ⬍</th>
              <th onClick={() => setSortKey('name')}>Produto ⬍</th>
              <th className="num" onClick={() => setSortKey('price')}>Preço ⬍</th>
              <th className="num">Preço/kg ou L</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o, i) => (
              <tr key={`${o.supermarket}-${o.name}-${i}`} className={o.price === cheapest ? 'cheapest' : ''}>
                <td>
                  <span
                    className="badge"
                    style={{ background: SUPERMARKET_COLORS[o.supermarket] ?? '#666' }}
                  >
                    {o.supermarket}
                  </span>
                </td>
                <td>{o.brand || '—'}</td>
                <td>
                  {o.url ? (
                    <a href={o.url} target="_blank" rel="noreferrer">{o.name}</a>
                  ) : (
                    o.name
                  )}
                  {o.promo && <span className="promo-tag"> {o.promo}</span>}
                </td>
                <td className="num price">
                  {o.price.toFixed(2)} €
                  {o.price === cheapest && <span className="best-tag"> melhor preço</span>}
                </td>
                <td className="num">
                  {o.unitPrice != null ? `${o.unitPrice.toFixed(2)} €/${o.unit ?? 'un'}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
