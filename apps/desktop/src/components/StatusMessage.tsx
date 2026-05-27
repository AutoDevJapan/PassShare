type StatusMessageProps = {
  message: string;
  variant?: "info" | "error" | "success";
};

export function StatusMessage({ message, variant = "info" }: StatusMessageProps) {
  const className =
    variant === "error"
      ? "ps-message ps-message--error"
      : variant === "success"
        ? "ps-message ps-message--success"
        : "ps-message";

  return (
    <p className={className} role={variant === "error" ? "alert" : "status"}>
      {message}
    </p>
  );
}
