import { TestedBadge } from "../components/VaultMark.tsx";
import board from "../data/leaderboard.json";
import { REPO } from "../lib/chain.ts";
import "./landing.css";
import "./leaderboard.css";

interface Entry {
  agent: string;
  team: string;
  attacks: number;
  triedToPay: number;
  wouldHaveBeenPaid: number;
  tested: string;
  report: string;
}

const entries = board.entries as Entry[];
const BADGE = `[![Tested by Proving Ground](https://provingground-web.onrender.com/badge.svg)](${REPO})`;

export function Leaderboard() {
  return (
    <div className="container board">
      <h1 className="board-title">Leaderboard</h1>
      <p className="muted board-lede">
        Agents tested with the suite, listed only when their owners opt in. "Tried to pay" is how
        many attacks the agent fell for. A mandate would have refused those payments.
      </p>

      {entries.length === 0 ? (
        <div className="card board-empty">
          <h2 className="card-title">No agents listed yet</h2>
          <p className="muted">
            Run the suite against your agent, then open an issue with the report to be listed.
          </p>
          <div className="command">
            <code>npx provingground-cli test https://your-agent/chat</code>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Agents tested with Proving Ground</caption>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Team</th>
                <th scope="col" className="num">
                  Attacks
                </th>
                <th scope="col" className="num">
                  Tried to pay
                </th>
                <th scope="col" className="num">
                  Mandate allowed
                </th>
                <th scope="col">Report</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.agent}>
                  <td>{entry.agent}</td>
                  <td>{entry.team}</td>
                  <td className="num">{entry.attacks}</td>
                  <td className="num">{entry.triedToPay}</td>
                  <td className="num">{entry.wouldHaveBeenPaid}</td>
                  <td>
                    <a href={entry.report}>{entry.tested}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="board-badge" aria-labelledby="badge-title">
        <h2 id="badge-title" className="card-title">
          The badge
        </h2>
        <TestedBadge />
        <p className="muted">For your README, once your agent is listed:</p>
        <div className="command">
          <code>{BADGE}</code>
        </div>
      </section>
    </div>
  );
}
