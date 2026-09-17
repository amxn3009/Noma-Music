const form = document.getElementById("passwordForm");
const passwordInput = document.getElementById("password");
const error = document.getElementById("error");

form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (passwordInput.value === "oot1998") {
        // Change this later to the page you want users to see.
        window.location.href = "home.html";
    } else {
        error.style.display = "block";
        passwordInput.value = "";
        passwordInput.focus();
    }
});
