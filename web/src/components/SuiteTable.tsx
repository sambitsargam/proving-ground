import { useMemo, useState } from "react";
import { explorerUrl, shortHash } from "../lib/chain.ts";
import { Icon } from "./Icon.tsx";
import { Status } from "./Status.tsx";

export interface ReportResult {
  id: string;
  title: string;
  category?: string;
  layer: string;
  decision: string;
  reason: string;
  checker_reasons: string[];
  stopped: boolean;
  tx_hash?: string;
}

const LAYERS = [
  { id: "all", label: "All" },
  { id: "key", label: "Key" },
  { id: "contract", label: "Contract" },
  { id: "checker", label: "Checker" },
] as const;

type LayerFilter = (typeof LAYERS)[number]["id"];

/** Every attack in the suite, with what stopped it and the testnet transaction. */
export function SuiteTable({
  suite,
  live,
}: {
  suite: ReportResult[];
  live: Map<string, ReportResult>;
}) {
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const byLayer: Record<string, number> = { all: suite.length };
    for (const result of suite) byLayer[result.layer] = (byLayer[result.layer] ?? 0) + 1;
    return byLayer;
  }, [suite]);
  const needle = query.trim().toLowerCase();
  const rows = suite.filter(
    (result) =>
      (layer === "all" || result.layer === layer) &&
      (!needle ||
        `${result.id} ${result.title} ${result.reason} ${result.category ?? ""}`
          .toLowerCase()
          .includes(needle)),
  );

  return (
    <div className="suite">
      <div className="suite-tools">
        <fieldset className="suite-filters">
          <legend className="visually-hidden">Stopped by</legend>
          {LAYERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className="chip"
              aria-pressed={layer === option.id}
              onClick={() => setLayer(option.id)}
            >
              {option.label} <span className="chip-count">{counts[option.id] ?? 0}</span>
            </button>
          ))}
        </fieldset>
        <label className="search">
          <Icon name="search" size={16} />
          <span className="visually-hidden">Search attacks</span>
          <input
            type="search"
            value={query}
            placeholder="Search attacks or reason codes"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="table-wrap">
        <table className="table suite-table">
          <caption className="visually-hidden">
            Every attack in the suite and what stopped it. Showing {rows.length} of {suite.length}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Attack</th>
              <th scope="col">Stopped by</th>
              <th scope="col">Reason</th>
              <th scope="col">On testnet</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((result, index) => {
              const onChain = live.get(result.id);
              return (
                <tr key={result.id} style={{ animationDelay: `${Math.min(index, 12) * 24}ms` }}>
                  <td>
                    <span className="mono row-id">{result.id}</span> {result.title}
                  </td>
                  <td>
                    <span className={`layer-tag layer-${result.layer}`}>{result.layer}</span>
                  </td>
                  <td className="mono">{result.reason}</td>
                  <td>
                    {onChain?.tx_hash ? (
                      <a className="mono" href={explorerUrl(onChain.tx_hash)}>
                        {shortHash(onChain.tx_hash)}
                      </a>
                    ) : onChain ? (
                      <Status tone="safe">Refused</Status>
                    ) : (
                      <span className="muted">Mock only</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="suite-empty">
            <p>No attack matches "{query}".</p>
            <button
              type="button"
              className="button button-ghost button-small"
              onClick={() => {
                setQuery("");
                setLayer("all");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
