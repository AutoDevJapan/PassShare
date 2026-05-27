const MATRIX_CHARS = "パスワードボックス0123456789ABCDEF";

function randomChars(length: number): string {
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
  }
  return result;
}

const COLUMNS = Array.from({ length: 24 }, (_, index) => ({
  id: index,
  left: `${(index / 24) * 100}%`,
  delay: `${(index * 0.35) % 8}s`,
  duration: `${6 + (index % 5)}s`,
  text: randomChars(18),
}));

export function MatrixBackground() {
  return (
    <div className="matrix-rain" aria-hidden="true">
      {COLUMNS.map((column) => (
        <span
          key={column.id}
          className="matrix-rain__column"
          style={{
            left: column.left,
            animationDelay: column.delay,
            animationDuration: column.duration,
          }}
        >
          {column.text}
        </span>
      ))}
    </div>
  );
}
