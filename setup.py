from setuptools import setup, find_packages
with open("requirements.txt") as f:
    install_requires = f.read().strip().split("\n")
setup(
    name="zoho_books_clone",
    version="1.0.0",
    description="A ZOHO Books-like accounting app built on Frappe",
    author="Your Company",
    author_email="dev@yourcompany.com",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=install_requires,
)
