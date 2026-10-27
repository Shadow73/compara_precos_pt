import { useState } from 'react';

interface Props {
  onSearch: (term: string) => void;
  loading: boolean;
}

export default function SearchBox({ onSearch, loading }: Props) {
  const [value, setValue] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearch(value);
  }

  return (
    <form className="search-box" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Ex.: arroz agulha, leite meio gordo, azeite virgem extra…"
        autoFocus
      />
      <button type="submit" disabled={loading || !value.trim()}>
        {loading ? 'A pesquisar…' : 'Comparar'}
      </button>
    </form>
  );
}
