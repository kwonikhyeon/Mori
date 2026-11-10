// The server would not answer at this address (spec §3 #193): a name it
// does not go by. Nothing else works from here, so the page says why.
import type { ApiError } from '../lib/api'
import './pair.css'

export function Refused({ err }: { err: ApiError }) {
  return (
    <div class="pair">
      <div class="pair-card" role="alert">
        <p class="pair-brand">Mori</p>
        <div class="pair-intro">
          <h1>{err.message}</h1>
          <p class="pair-host">
            지금 연 주소: <b>{location.host}</b>
          </p>
        </div>
        {err.hint && <p class="pair-hint">{err.hint}</p>}
      </div>
    </div>
  )
}
