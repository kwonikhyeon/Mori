// A screen whose real view comes in a later step of stage 10.
import { Icon } from '../components/Icon'

export function Pending({ title, back }: { title: string; back?: string }) {
  return (
    <div class="pending">
      {back && (
        <header class="pending-head">
          <a class="btn btn-icon btn-ghost" href={back} aria-label="뒤로">
            <Icon name="back" size={20} />
          </a>
          <h1>{title}</h1>
        </header>
      )}
      <div class="empty">
        <p class="empty-title">{title}</p>
        <p class="empty-text">이 화면은 아직 만들고 있습니다.</p>
      </div>
    </div>
  )
}
