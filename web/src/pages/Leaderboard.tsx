import { TestedBadge, VaultMark } from "../components/VaultMark.tsx";
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
      <p className="eyebrow board-eyebrow">Opt-in results</p>
      <h1 className="board-title">Leaderboard</h1>
      <p className="muted board-lede">
        Agents tested with the suite, listed only when their owners opt in. "Tried to pay" is how
        many attacks the agent fell for. A mandate would have refused those payments.
      </p>

      {entries.length === 0 ? (
        <div className="card board-empty">
          <div className="board-empty-head">
            <VaultMark size={40} />
            <div>
              <h2 className="card-title">No agents listed yet. Be the first.</h2>
              <p className="muted">Three steps from your agent to this table.</p>
            </div>
          </div>
          <ol className="onboard">
            <li>
              <span className="onboard-num">1</span>
              <div>
                <h3>Run the suite against your agent</h3>
                <div className="command">
                  <code>npx provingground-cli test https://your-agent/chat</code>
                </div>
              </div>
            </li>
            <li>
              <span className="onboard-num">2</span>
              <div>
                <h3>Open an issue with the report</h3>
                <p className="muted">
                  Attach <code>report.json</code>. We list agents only when their owners ask.{" "}
                  <a href={`${REPO}/issues/new`}>Open an issue</a>
                </p>
              </div>
            </li>
            <li>
              <span className="onboard-num">3</span>
              <div>
                <h3>Put the badge on your README</h3>
                <p className="muted">It links back to your results here.</p>
              </div>
            </li>
          </ol>
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
